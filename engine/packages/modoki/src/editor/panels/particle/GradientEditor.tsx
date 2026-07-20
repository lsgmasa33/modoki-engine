/** Compact color+alpha gradient editor for colorOverLife.
 *  Two strips (color, alpha) with draggable stops. Click a stop to edit it,
 *  double-click a strip to add a stop, right-click a stop to remove.
 *
 *  Stops are tracked by OBJECT IDENTITY, never by array index. The persisted
 *  arrays are always kept sorted by `t` (the runtime `sampleGradientColor`
 *  early-returns on the first stop with `t >= queryT`, so an unsorted array
 *  samples wrong colors). Because index-into-the-sorted-copy drifts the instant
 *  a dragged stop crosses a neighbor, drag/selection carry the stop reference
 *  forward across each `onChange`. */

import { useRef, useState, useCallback, useEffect } from 'react';
import type { Gradient, ColorStop, AlphaStop } from '@modoki/engine/runtime';
import { hexToRgb, rgbToHex, tAt as tAtPx } from './gradientMath';
import { registerHandleProvider, type InteractionHandle } from '../../../runtime/rendering/interactionHandles';

interface Props {
  value: Gradient;
  /** Second arg is a per-edit undo-group suffix so distinct stop edits (a color stop
   *  vs an alpha stop, or two different stops) don't coalesce into one undo step, while
   *  consecutive moves of the SAME stop still collapse. */
  onChange: (g: Gradient, groupSuffix?: string) => void;
}

type Stop = ColorStop | AlphaStop;

const byT = (a: Stop, b: Stop) => a.t - b.t;

type Sel = { kind: 'color' | 'alpha'; stop: Stop } | null;

export default function GradientEditor({ value, onChange }: Props) {
  // Sorted copies for rendering — these hold the SAME object references as the
  // persisted arrays (a spread + sort preserves element identity), so a `=== stop`
  // comparison works across the sorted view and the persisted value.
  const colorStops = [...value.colorStops].sort(byT);
  const alphaStops = [...value.alphaStops].sort(byT);
  const [sel, setSel] = useState<Sel>(null);
  const dragRef = useRef<Sel>(null);
  // A fresh group id minted on each pointer-down so two DIFFERENT stop drags get distinct
  // undo groups (and thus distinct undo steps), while consecutive moves of the SAME drag
  // share one. Carried for the lifetime of the active drag.
  const dragGroupRef = useRef('');
  const dragSeq = useRef(0);
  const barRef = useRef<Record<string, HTMLDivElement | null>>({});

  const colorCss = colorStops.length
    ? `linear-gradient(to right, ${colorStops.map((s) => `${rgbToHex(s.color)} ${(s.t * 100).toFixed(1)}%`).join(', ')})`
    : '#888';
  const alphaCss = alphaStops.length
    ? `linear-gradient(to right, ${alphaStops.map((s) => `rgb(${(s.alpha * 255) | 0},${(s.alpha * 255) | 0},${(s.alpha * 255) | 0}) ${(s.t * 100).toFixed(1)}%`).join(', ')})`
    : '#fff';

  const tAt = useCallback((kind: 'color' | 'alpha', clientX: number) => {
    const el = barRef.current[kind];
    if (!el) return 0;
    return tAtPx(clientX, el.getBoundingClientRect());
  }, []);

  // Replace `prev` (by reference) with `next` in the matching persisted array,
  // re-sort, and emit. Returns the moved object so callers can carry the ref forward.
  const commit = (kind: 'color' | 'alpha', prev: Stop, next: Stop, group?: string) => {
    if (kind === 'color') {
      const arr = (value.colorStops as ColorStop[]).map((s) => (s === prev ? (next as ColorStop) : s)).sort(byT);
      onChange({ ...value, colorStops: arr }, group);
    } else {
      const arr = (value.alphaStops as AlphaStop[]).map((s) => (s === prev ? (next as AlphaStop) : s)).sort(byT);
      onChange({ ...value, alphaStops: arr }, group);
    }
  };

  const onMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    const t = tAt(d.kind, e.clientX);
    const moved = { ...d.stop, t } as Stop;
    commit(d.kind, d.stop, moved, dragGroupRef.current);
    // Carry the reference forward so the next move (and the selection highlight)
    // still track THIS stop even after it crosses a neighbor and the sort reorders.
    dragRef.current = { kind: d.kind, stop: moved };
    setSel({ kind: d.kind, stop: moved });
  };
  const endDrag = () => { dragRef.current = null; };

  const addColor = (e: React.MouseEvent) => {
    const t = tAt('color', e.clientX);
    onChange({ ...value, colorStops: [...value.colorStops, { t, color: { r: 1, g: 1, b: 1 } }].sort(byT) }, `color:add:${dragSeq.current++}`);
  };
  const addAlpha = (e: React.MouseEvent) => {
    const t = tAt('alpha', e.clientX);
    onChange({ ...value, alphaStops: [...value.alphaStops, { t, alpha: 1 }].sort(byT) }, `alpha:add:${dragSeq.current++}`);
  };

  const handle = (kind: 'color' | 'alpha', stop: Stop, i: number, fill: string) => (
    <div
      key={`${kind}-${i}`}
      onPointerDown={(e) => { e.stopPropagation(); (e.target as Element).setPointerCapture(e.pointerId); dragRef.current = { kind, stop }; dragGroupRef.current = `${kind}:drag:${dragSeq.current++}`; setSel({ kind, stop }); }}
      onContextMenu={(e) => {
        e.preventDefault(); e.stopPropagation();
        const stops = kind === 'color' ? value.colorStops : value.alphaStops;
        if (stops.length <= 1) return;
        if (kind === 'color') onChange({ ...value, colorStops: (value.colorStops as ColorStop[]).filter((s) => s !== stop) }, `color:remove:${dragSeq.current++}`);
        else onChange({ ...value, alphaStops: (value.alphaStops as AlphaStop[]).filter((s) => s !== stop) }, `alpha:remove:${dragSeq.current++}`);
        setSel(null);
      }}
      title="drag to move · right-click to remove"
      style={{
        position: 'absolute', top: -3, left: `calc(${stop.t * 100}% - 5px)`, width: 10, height: 'calc(100% + 6px)',
        background: fill, border: `1px solid ${sel && sel.kind === kind && sel.stop === stop ? '#fff' : '#000'}`,
        borderRadius: 2, cursor: 'grab', boxSizing: 'border-box',
      }}
    />
  );

  // ── Enact: expose each color/alpha stop as an interaction handle (viewport CSS px).
  // Inverts `tAt` exactly (which uses rect.left + t·rect.width, no border/PAD term), one
  // handle per stop centred vertically on its own strip. Each strip has its own rect
  // (different heights/y), so use the matching barRef. Live state via a ref → register
  // once. Index is the sorted-view position (stable across a single read→drag).
  const gradHandleStateRef = useRef<{ colorStops: Stop[]; alphaStops: Stop[] }>({ colorStops, alphaStops });
  gradHandleStateRef.current = { colorStops, alphaStops };
  useEffect(() => {
    const unreg = registerHandleProvider((): InteractionHandle[] => {
      const st = gradHandleStateRef.current;
      const out: InteractionHandle[] = [];
      for (const kind of ['color', 'alpha'] as const) {
        const el = barRef.current[kind];
        if (!el) continue;
        const rect = el.getBoundingClientRect();
        if (!rect.width || !rect.height) continue;
        const stops = kind === 'color' ? st.colorStops : st.alphaStops;
        stops.forEach((s, i) => {
          out.push({
            id: `particle:gradient:${kind}:${i}`,
            kind: 'gradient-stop',
            editor: 'particle',
            x: rect.left + s.t * rect.width,
            y: rect.top + rect.height / 2,
            label: `${kind} stop t=${s.t.toFixed(2)}`,
            meta: { strip: kind, index: i, t: s.t },
          });
        });
      }
      return out;
    });
    return unreg;
  }, []);

  const selColor = sel?.kind === 'color' ? (sel.stop as ColorStop) : null;
  const selAlpha = sel?.kind === 'alpha' ? (sel.stop as AlphaStop) : null;

  return (
    <div style={{ marginBottom: 6 }} onPointerMove={onMove} onPointerUp={endDrag}>
      <div style={{ color: '#999', fontSize: 10, marginBottom: 2 }}>Color over life</div>
      <div ref={(el) => { barRef.current.color = el; }} onDoubleClick={addColor}
        style={{ position: 'relative', height: 18, background: colorCss, border: '1px solid #333', borderRadius: 3, cursor: 'copy' }}>
        {colorStops.map((s, i) => handle('color', s, i, rgbToHex(s.color)))}
      </div>
      <div ref={(el) => { barRef.current.alpha = el; }} onDoubleClick={addAlpha}
        style={{ position: 'relative', height: 12, marginTop: 8, background: alphaCss, border: '1px solid #333', borderRadius: 3, cursor: 'copy' }}>
        {alphaStops.map((s, i) => handle('alpha', s, i, `rgba(255,255,255,${s.alpha})`))}
      </div>

      {selColor && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 6 }}>
          <span style={{ color: '#888', fontSize: 10 }}>stop {(selColor.t * 100).toFixed(0)}%</span>
          <input type="color" value={rgbToHex(selColor.color)}
            onChange={(e) => { const next = { ...selColor, color: hexToRgb(e.target.value) }; commit('color', selColor, next, 'color:pick'); setSel({ kind: 'color', stop: next }); }} />
        </div>
      )}
      {selAlpha && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 6 }}>
          <span style={{ color: '#888', fontSize: 10 }}>alpha {(selAlpha.t * 100).toFixed(0)}%</span>
          <input type="range" min={0} max={1} step={0.01} value={selAlpha.alpha}
            onChange={(e) => { const next = { ...selAlpha, alpha: +e.target.value }; commit('alpha', selAlpha, next, 'alpha:slide'); setSel({ kind: 'alpha', stop: next }); }} />
        </div>
      )}
    </div>
  );
}
