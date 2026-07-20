/** Compact SVG curve editor for particle over-life values (piecewise-linear, t,v ∈ [0,1]).
 *  Drag points to move; double-click empty space to add; right-click a point to remove.
 *  Endpoints keep t at 0 and 1; interior points move freely in t between neighbors. */

import { useRef, useCallback, useEffect } from 'react';
import type { CurvePoint } from '@modoki/engine/runtime';
import { curveX, curveY, editPoint, PAD, toLocal as toLocalPx } from './curveMath';
import { registerHandleProvider, type InteractionHandle } from '../../../runtime/rendering/interactionHandles';

const slug = (s: string | undefined) => (s ?? 'curve').toLowerCase().replace(/[^a-z0-9]+/g, '-');

interface Props {
  /** Per-edit undo-group suffix. The parent threads this into `patch`'s group so that
   *  two DIFFERENT point drags don't coalesce into one undo step, while consecutive
   *  moves of the SAME point still collapse. e.g. `point:${i}` on a drag. */
  points: CurvePoint[];
  onChange: (points: CurvePoint[], groupSuffix?: string) => void;
  height?: number;
  color?: string;
  label?: string;
}

export default function CurveEditor({ points, onChange, height = 96, color = '#4fd1c5', label }: Props) {
  const ref = useRef<SVGSVGElement | null>(null);
  const dragRef = useRef<number | null>(null);

  const sorted = [...points].sort((a, b) => a.t - b.t);
  const pts = sorted.length >= 2 ? sorted : [{ t: 0, v: 1 }, { t: 1, v: 1 }];

  const toLocal = useCallback((clientX: number, clientY: number) => toLocalPx(clientX, clientY, ref.current!.getBoundingClientRect()), []);

  // ── Enact: expose each curve point as an interaction handle (viewport CSS px). The
  // grabbable target is the <circle>, DRAWN in viewBox units at cx=curveX(t,W), cy=curveY(v,H)
  // with W=240 and preserveAspectRatio="none" stretching viewBox→CSS non-uniformly. So the
  // circle's screen pos is curveX/curveY(viewBox) × (rect.size/viewBox.size) — NOT the
  // toLocal inversion (which treats PAD as CSS px and only agrees when rect.width===240).
  // Landing ON the circle is what matters: pointer-down capture is on the circle element.
  // Two instances (Size, Opacity) each register; namespace by `label`. Live via a ref.
  const CURVE_VBW = 240; // viewBox width (must match the render's `const W = 240`)
  const curveHandleStateRef = useRef<{ pts: CurvePoint[]; label: string | undefined; vbh: number }>({ pts, label, vbh: height });
  curveHandleStateRef.current = { pts, label, vbh: height };
  useEffect(() => {
    const unreg = registerHandleProvider((): InteractionHandle[] => {
      const svg = ref.current;
      if (!svg) return [];
      const st = curveHandleStateRef.current;
      const rect = svg.getBoundingClientRect();
      if (!rect.width || !rect.height) return [];
      const sx = rect.width / CURVE_VBW, sy = rect.height / st.vbh;
      return st.pts.map((p, i) => ({
        id: `particle:curve:${slug(st.label)}:${i}`,
        kind: 'curve-point',
        editor: 'particle',
        x: rect.left + curveX(p.t, CURVE_VBW) * sx,
        y: rect.top + curveY(p.v, st.vbh) * sy,
        label: `${st.label ?? 'curve'} pt${i} (t=${p.t.toFixed(2)}, v=${p.v.toFixed(2)})`,
        meta: { curve: st.label, index: i, t: p.t, v: p.v, endpoint: i === 0 || i === st.pts.length - 1 },
      }));
    });
    return unreg;
  }, []);

  const X = curveX;
  const Y = curveY;

  const onPointerDownPoint = (i: number) => (e: React.PointerEvent) => {
    e.stopPropagation();
    (e.target as Element).setPointerCapture(e.pointerId);
    dragRef.current = i;
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const i = dragRef.current;
    if (i == null) return;
    const { t, v } = toLocal(e.clientX, e.clientY);
    // endpoints keep their t; interior points clamp between neighbours
    const next = editPoint(pts, i, t, v);
    onChange(next, `point:${i}`);
  };

  const onPointerUp = (e: React.PointerEvent) => {
    if (dragRef.current != null) { try { (e.target as Element).releasePointerCapture(e.pointerId); } catch { /* */ } }
    dragRef.current = null;
  };

  const onDoubleClick = (e: React.MouseEvent) => {
    const { t, v } = toLocal(e.clientX, e.clientY);
    const next = [...pts, { t, v }].sort((a, b) => a.t - b.t);
    onChange(next, 'add');
  };

  const removePoint = (i: number) => (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (i === 0 || i === pts.length - 1) return; // keep endpoints
    onChange(pts.filter((_, k) => k !== i), `remove:${i}`);
  };

  // viewBox uses a fixed coordinate space; CSS scales it. Use 100x(height) units.
  const W = 240;
  const poly = pts.map((p) => `${X(p.t, W)},${Y(p.v, height)}`).join(' ');

  return (
    <div style={{ marginBottom: 4 }}>
      {label && <div style={{ color: '#999', fontSize: 10, marginBottom: 2 }}>{label}</div>}
      <svg
        ref={ref}
        viewBox={`0 0 ${W} ${height}`}
        preserveAspectRatio="none"
        style={{ width: '100%', height, background: '#15151f', border: '1px solid #333', borderRadius: 3, display: 'block', cursor: 'crosshair', touchAction: 'none' }}
        onDoubleClick={onDoubleClick}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
      >
        {/* gridlines */}
        {[0.25, 0.5, 0.75].map((g) => (
          <line key={g} x1={PAD} x2={W - PAD} y1={Y(g, height)} y2={Y(g, height)} stroke="#262636" strokeWidth={1} />
        ))}
        <polyline points={poly} fill="none" stroke={color} strokeWidth={1.5} />
        {pts.map((p, i) => (
          <circle
            key={i}
            cx={X(p.t, W)} cy={Y(p.v, height)} r={4}
            fill={color} stroke="#0b0b16" strokeWidth={1}
            style={{ cursor: 'grab' }}
            onPointerDown={onPointerDownPoint(i)}
            onContextMenu={removePoint(i)}
          />
        ))}
      </svg>
    </div>
  );
}
