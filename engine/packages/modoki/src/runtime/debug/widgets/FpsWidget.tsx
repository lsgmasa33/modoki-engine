/** FPS widget — live frames-per-second chart + current value. */

import type { CSSProperties } from 'react';
import { Sparkline } from '../Sparkline';
import { useSampledHistory } from '../useSampled';
import { getFps } from '../perfSources';

const HISTORY = 60;
const SAMPLE_MS = 500;
const fpsColor = (fps: number) => (fps >= 55 ? '#4ade80' : fps >= 30 ? '#fbbf24' : '#f87171');

export function FpsWidget() {
  const hist = useSampledHistory(getFps, SAMPLE_MS, HISTORY);
  const fps = hist[hist.length - 1] ?? 0;
  const color = fpsColor(fps);
  return (
    <div>
      <div style={rowStyle}>
        <span style={labelStyle}>FPS</span>
        <span style={{ ...valueStyle, color }}>{Math.round(fps)}</span>
      </div>
      <Sparkline data={hist} color={color} max={Math.max(60, ...hist)} min={0} width={168} height={38} />
    </div>
  );
}

const rowStyle: CSSProperties = { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 3 };
const labelStyle: CSSProperties = { fontSize: 11, color: '#8b8ba7', textTransform: 'uppercase', letterSpacing: 0.5 };
const valueStyle: CSSProperties = { fontSize: 20, fontWeight: 700, fontVariantNumeric: 'tabular-nums' };
