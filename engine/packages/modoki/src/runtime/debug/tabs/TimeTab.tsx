/** Time tab — the single time-control knob (`timeScale`) + a live time readout.
 *
 *  Uses `timeScale` (0 = pause/time-stop, 0.3 = slow-mo, 2 = fast — the sanctioned
 *  control per the engine docs) rather than driving `playState`: playState is owned
 *  by the editor's snapshot-based enterPlay/stopPlay, so poking it from here would
 *  bypass the snapshot. timeScale is safe and identical in a shipped game AND the
 *  editor. Readouts (frame/elapsed/delta/state) refresh on a slow interval. */

import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { getCurrentWorld } from '../../ecs/world';
import { getTime, getTimeScale, setTimeScale } from '../../systems/getTime';
import { getPlayState } from '../../systems/playState';

const REFRESH_MS = 200;
const PRESETS = [0.25, 0.5, 1, 2];

export function TimeTab() {
  const [, setTick] = useState(0);
  const lastNonZero = useRef(1);

  useEffect(() => {
    const id = window.setInterval(() => setTick((t) => t + 1), REFRESH_MS);
    return () => window.clearInterval(id);
  }, []);

  const world = getCurrentWorld();
  const time = getTime(world);
  const scale = getTimeScale(world);
  if (scale > 0) lastNonZero.current = scale;
  const paused = scale === 0;

  // Bump the tick so controls (slider thumb, Pause↔Resume label) reflect the change
  // immediately instead of waiting for the next refresh interval.
  const setScale = (v: number) => {
    setTimeScale(world, v);
    setTick((t) => t + 1);
  };
  const togglePause = () => setScale(paused ? lastNonZero.current || 1 : 0);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <section>
        <div style={rowStyle}>
          <span style={labelStyle}>Time scale</span>
          <span style={{ ...valueStyle, color: paused ? '#f87171' : scale === 1 ? '#e6e6ff' : '#fbbf24' }}>
            {scale.toFixed(2)}×
          </span>
        </div>
        <input
          type="range"
          min={0}
          max={3}
          step={0.05}
          value={scale}
          onChange={(e) => setScale(parseFloat(e.target.value))}
          style={{ width: '100%' }}
        />
        <div style={{ display: 'flex', gap: 4, marginTop: 6, flexWrap: 'wrap' }}>
          <button style={{ ...btnStyle, ...(paused ? btnActiveStyle : null) }} onClick={togglePause}>
            {paused ? '▶ Resume' : '⏸ Pause'}
          </button>
          {PRESETS.map((p) => (
            <button key={p} style={{ ...btnStyle, ...(scale === p ? btnActiveStyle : null) }} onClick={() => setScale(p)}>
              {p}×
            </button>
          ))}
        </div>
      </section>

      <section style={gridStyle}>
        <Stat k="State" v={getPlayState()} />
        <Stat k="Frame" v={time ? time.frame : '—'} />
        <Stat k="Elapsed" v={time ? `${time.elapsed.toFixed(1)}s` : '—'} />
        <Stat k="Delta" v={time ? `${(time.delta * 1000).toFixed(1)}ms` : '—'} />
      </section>
      {!time && <div style={mutedStyle}>No Time resource in the world yet.</div>}
    </div>
  );
}

function Stat({ k, v }: { k: string; v: number | string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      <span style={{ fontSize: 10, color: '#8b8ba7', textTransform: 'uppercase', letterSpacing: 0.4 }}>{k}</span>
      <span style={{ fontSize: 14, fontVariantNumeric: 'tabular-nums', color: '#e6e6ff' }}>{v}</span>
    </div>
  );
}

const rowStyle: CSSProperties = { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 4 };
const labelStyle: CSSProperties = { fontSize: 12, color: '#8b8ba7', textTransform: 'uppercase', letterSpacing: 0.5 };
const valueStyle: CSSProperties = { fontSize: 18, fontWeight: 600, fontVariantNumeric: 'tabular-nums' };
const gridStyle: CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '8px 8px' };
const btnStyle: CSSProperties = {
  background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.15)', color: '#c4b5fd',
  cursor: 'pointer', fontSize: 12, padding: '4px 8px', borderRadius: 4,
};
const btnActiveStyle: CSSProperties = { background: 'rgba(99,102,241,0.3)', color: '#e6e6ff' };
const mutedStyle: CSSProperties = { fontSize: 11, color: '#6b6b85', fontStyle: 'italic' };
