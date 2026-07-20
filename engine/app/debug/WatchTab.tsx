/** Watch tab — numeric time-series charts for the in-game debug menu.
 *
 *  EDITOR-ONLY: the Watch observer (`app/debug/watch.ts`) is editor-side infra that
 *  is stripped from shipped game builds, so this tab lives in `app/` (not `runtime/`)
 *  and self-registers only when the editor loads (gated by a side-effect import in
 *  main.tsx behind `__MODOKI_EDITOR__`). It reuses the runtime `Sparkline`.
 *
 *  Start a watch by component (optionally a comma-separated field list); each numeric
 *  series is charted with change-filtered samples + last/min/max stats. */

import { useEffect, useState } from 'react';
import type { CSSProperties } from 'react';
import { registerDebugTab } from '@modoki/engine/runtime';
import { Sparkline } from '@modoki/engine/runtime/debug';
import { startWatch, readWatch, listWatches, clearWatch } from './watch';

const REFRESH_MS = 300;

interface WatchListItem { id: string; component: string; fields: string[]; seriesCount: number }
interface SeriesStats { first: number; last: number; min: number; max: number; delta: number; settled: boolean }
interface SeriesItem { guid: string; field: string; count: number; despawnedAt?: number; stats: SeriesStats | null; samples: { tick: number; value: number }[] }

function WatchTab() {
  const [, setTick] = useState(0);
  const [component, setComponent] = useState('');
  const [fields, setFields] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const id = window.setInterval(() => setTick((t) => t + 1), REFRESH_MS);
    return () => window.clearInterval(id);
  }, []);

  const watches = (listWatches() as { watches: WatchListItem[] }).watches;

  const start = () => {
    const name = component.trim();
    if (!name) return;
    const fieldList = fields.split(',').map((f) => f.trim()).filter(Boolean);
    const res = startWatch({ component: name, fields: fieldList.length ? fieldList : undefined }) as { ok: boolean; error?: string };
    if (!res.ok) setError(res.error ?? 'failed to start watch');
    else {
      setError(null);
      setComponent('');
      setFields('');
    }
    setTick((t) => t + 1);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <div style={{ display: 'flex', gap: 4 }}>
          <input style={inputStyle} placeholder="component (e.g. Transform)" value={component} onChange={(e) => setComponent(e.target.value)} />
          <button style={btnStyle} onClick={start}>Watch</button>
        </div>
        <input style={inputStyle} placeholder="fields (optional, comma-separated)" value={fields} onChange={(e) => setFields(e.target.value)} />
        {error && <div style={errorStyle}>{error}</div>}
      </div>

      {watches.length === 0 ? (
        <div style={mutedStyle}>No active watches. Start one above to chart a numeric trait field over time.</div>
      ) : (
        watches.map((w) => <WatchCard key={w.id} id={w.id} />)
      )}
    </div>
  );
}

function WatchCard({ id }: { id: string }) {
  const data = readWatch(id) as { ok: boolean; component: string; fields: string[]; series: SeriesItem[] };
  if (!data.ok) return null;
  const series = data.series.slice(0, 8); // cap for the narrow panel
  return (
    <div style={cardStyle}>
      <div style={cardHeaderStyle}>
        <span style={{ color: '#a5b4fc', fontWeight: 600 }}>{data.component}</span>
        <button style={smallBtnStyle} onClick={() => clearWatch(id)}>✕</button>
      </div>
      {series.length === 0 ? (
        <div style={mutedStyle}>collecting… (values change to record)</div>
      ) : (
        series.map((s) => (
          <div key={`${s.guid}:${s.field}`} style={{ marginTop: 4 }}>
            <div style={seriesLabelStyle}>
              <span>{s.field}</span>
              <span style={{ color: '#e6e6ff', fontVariantNumeric: 'tabular-nums' }}>{s.stats ? fmt(s.stats.last) : '—'}</span>
            </div>
            <Sparkline data={s.samples.map((x) => x.value)} color={s.despawnedAt != null ? '#6b6b85' : '#4ade80'} width={264} height={34} />
            {s.stats && (
              <div style={statsRowStyle}>
                <span>min {fmt(s.stats.min)}</span>
                <span>max {fmt(s.stats.max)}</span>
                <span>Δ {fmt(s.stats.delta)}</span>
                {s.stats.settled && <span style={{ color: '#fbbf24' }}>settled</span>}
              </div>
            )}
          </div>
        ))
      )}
    </div>
  );
}

function fmt(v: number): string {
  return Number.isInteger(v) ? String(v) : v.toFixed(3);
}

registerDebugTab({ id: 'watch', title: 'Watch', order: 25, Component: WatchTab });

const inputStyle: CSSProperties = { flex: 1, background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.15)', borderRadius: 4, color: '#e6e6ff', fontSize: 12, padding: '3px 6px' };
const btnStyle: CSSProperties = { background: 'rgba(99,102,241,0.2)', border: '1px solid rgba(99,102,241,0.4)', color: '#c7d2fe', cursor: 'pointer', fontSize: 12, padding: '3px 10px', borderRadius: 4 };
const smallBtnStyle: CSSProperties = { background: 'transparent', border: 'none', color: '#8b8ba7', cursor: 'pointer', fontSize: 12, padding: 0 };
const cardStyle: CSSProperties = { border: '1px solid rgba(255,255,255,0.1)', borderRadius: 6, padding: 8 };
const cardHeaderStyle: CSSProperties = { display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 12 };
const seriesLabelStyle: CSSProperties = { display: 'flex', justifyContent: 'space-between', fontSize: 11, color: '#8b8ba7', marginBottom: 2 };
const statsRowStyle: CSSProperties = { display: 'flex', gap: 8, fontSize: 10, color: '#6b6b85', marginTop: 2, fontVariantNumeric: 'tabular-nums' };
const errorStyle: CSSProperties = { color: '#f87171', fontSize: 11 };
const mutedStyle: CSSProperties = { fontSize: 11, color: '#6b6b85', fontStyle: 'italic', lineHeight: 1.5 };
