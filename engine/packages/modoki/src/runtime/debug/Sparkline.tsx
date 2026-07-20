/** Sparkline — a tiny hand-rolled <canvas> line chart for the debug menu.
 *  Zero dependencies (no chart.js). Draws a polyline of `data` autoscaled to its
 *  own min/max (or a fixed 0..max when `max` is given), a faint baseline grid, and
 *  a filled area under the line. Redraws whenever `data` changes.
 *
 *  Exported pure math (`sparkPoints`) is unit-tested. */

import { useEffect, useRef } from 'react';

export interface SparklineProps {
  /** Sample values, oldest → newest. */
  data: number[];
  width?: number;
  height?: number;
  /** Line/fill colour (CSS). */
  color?: string;
  /** Fixed upper bound; when omitted the chart autoscales to `max(data)`. */
  max?: number;
  /** Fixed lower bound; defaults to `min(data)` (autoscale) or 0 when `max` set. */
  min?: number;
}

/** Map samples to canvas polyline points. Pure — unit-tested.
 *  `lo`/`hi` are the value range mapped to the full [h, 0] pixel span. */
export function sparkPoints(
  data: number[],
  w: number,
  h: number,
  lo: number,
  hi: number,
): Array<{ x: number; y: number }> {
  const n = data.length;
  if (n === 0) return [];
  const span = hi - lo || 1;
  const stepX = n > 1 ? w / (n - 1) : 0;
  return data.map((v, i) => {
    const t = (v - lo) / span; // 0..1 (clamped)
    const ct = t < 0 ? 0 : t > 1 ? 1 : t;
    return { x: i * stepX, y: h - ct * h };
  });
}

export function Sparkline({ data, width = 220, height = 44, color = '#4ade80', max, min }: SparklineProps) {
  const ref = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    // Baseline grid (mid line).
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, height / 2);
    ctx.lineTo(width, height / 2);
    ctx.stroke();

    if (data.length === 0) return;

    // Reduce, not Math.max(...data) — a spread overflows the call stack on a large
    // series (Watch can hold thousands of samples). See watch.ts minOf/maxOf.
    const dMax = max ?? data.reduce((m, v) => (v > m ? v : m), -Infinity);
    const dMin = min ?? (max != null ? 0 : data.reduce((m, v) => (v < m ? v : m), Infinity));
    const hi = dMax === dMin ? dMax + 1 : dMax;
    const lo = dMax === dMin ? dMax - 1 : dMin;
    const pts = sparkPoints(data, width, height, lo, hi);

    // Filled area.
    ctx.beginPath();
    ctx.moveTo(pts[0].x, height);
    for (const p of pts) ctx.lineTo(p.x, p.y);
    ctx.lineTo(pts[pts.length - 1].x, height);
    ctx.closePath();
    ctx.fillStyle = hexToRgba(color, 0.15);
    ctx.fill();

    // Line.
    ctx.beginPath();
    pts.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.lineJoin = 'round';
    ctx.stroke();
  }, [data, width, height, color, max, min]);

  return <canvas ref={ref} style={{ width, height, display: 'block' }} />;
}

function hexToRgba(hex: string, alpha: number): string {
  let h = hex.replace('#', '');
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2]; // #abc → #aabbcc
  const m = /^([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(h);
  if (!m) return hex; // named/other color — no alpha applied
  return `rgba(${parseInt(m[1], 16)},${parseInt(m[2], 16)},${parseInt(m[3], 16)},${alpha})`;
}
