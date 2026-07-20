/** GPU widget — active rendering backend + live draw-call / geometry stats. */

import type { CSSProperties } from 'react';
import { useInterval } from '../useSampled';
import { readRenderer, getEntityCount } from '../perfSources';

export function GpuWidget() {
  useInterval(500);
  const r = readRenderer();
  return (
    <div>
      <div style={rowStyle}>
        <span style={labelStyle}>Renderer</span>
        <span style={{ ...valueStyle, color: '#c4b5fd' }}>{r?.backend ?? '—'}</span>
      </div>
      {r ? (
        <div style={gridStyle}>
          {/* draw calls / triangles are per-frame; the WebGPU backend doesn't always
              populate them → show '—' (not reported) rather than a misleading 0. */}
          <Cell k="calls" v={r.calls || '—'} />
          <Cell k="tris" v={r.triangles ? r.triangles.toLocaleString() : '—'} />
          <Cell k="geom" v={r.geometries} />
          <Cell k="tex" v={r.textures} />
          {r.programs != null && <Cell k="prog" v={r.programs} />}
          <Cell k="ents" v={getEntityCount()} />
        </div>
      ) : (
        <div style={mutedStyle}>3D renderer not initialized.</div>
      )}
    </div>
  );
}

function Cell({ k, v }: { k: string; v: number | string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      <span style={cellKeyStyle}>{k}</span>
      <span style={cellValStyle}>{v}</span>
    </div>
  );
}

const rowStyle: CSSProperties = { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 5 };
const labelStyle: CSSProperties = { fontSize: 11, color: '#8b8ba7', textTransform: 'uppercase', letterSpacing: 0.5 };
const valueStyle: CSSProperties = { fontSize: 14, fontWeight: 700 };
const gridStyle: CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '6px 6px' };
const cellKeyStyle: CSSProperties = { fontSize: 9, color: '#6b6b85', textTransform: 'uppercase', letterSpacing: 0.3 };
const cellValStyle: CSSProperties = { fontSize: 13, fontVariantNumeric: 'tabular-nums', color: '#e6e6ff' };
const mutedStyle: CSSProperties = { fontSize: 10, color: '#6b6b85', fontStyle: 'italic' };
