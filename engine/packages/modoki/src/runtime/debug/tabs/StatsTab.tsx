/** Stats tab — a LAUNCHER for the floating performance widgets.
 *
 *  FPS / Memory / GPU each spawn as a small, half-transparent, draggable window that
 *  stays on screen while you play (the fullscreen modal would block the game). This
 *  tab toggles those widgets and shows a quick static snapshot; the live charts live
 *  in the widgets themselves. */

import { useSyncExternalStore, type CSSProperties } from 'react';
import { getStatWidgets, toggleWidget, isWidgetOpen, subscribeWidgets, getWidgetVersion } from '../widgetStore';
import { useInterval } from '../useSampled';
import { getFps, readRenderer, getEntityCount } from '../perfSources';

export function StatsTab() {
  useSyncExternalStore(subscribeWidgets, getWidgetVersion, getWidgetVersion);
  useInterval(500);
  const widgets = getStatWidgets();
  const rend = readRenderer();

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <section>
        <div style={headingStyle}>Performance monitors</div>
        <div style={hintStyle}>Spawn a floating widget to watch while playing — drag it anywhere; it stays on screen when this menu is closed.</div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 8 }}>
          {widgets.map((w) => {
            const on = isWidgetOpen(w.id);
            return (
              <button key={w.id} style={{ ...spawnBtnStyle, ...(on ? spawnBtnActiveStyle : null) }} onClick={() => toggleWidget(w.id)}>
                <span style={{ opacity: on ? 1 : 0.6 }}>{on ? '● ' : '○ '}</span>
                {w.title}
              </button>
            );
          })}
        </div>
      </section>

      <section>
        <div style={headingStyle}>Snapshot</div>
        <div style={gridStyle}>
          <Stat k="FPS" v={Math.round(getFps())} />
          <Stat k="Renderer" v={rend?.backend ?? '—'} />
          <Stat k="Draw calls" v={rend?.calls || '—'} />
          <Stat k="Entities" v={getEntityCount()} />
        </div>
      </section>
    </div>
  );
}

function Stat({ k, v }: { k: string; v: number | string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      <span style={{ fontSize: 10, color: '#8b8ba7', textTransform: 'uppercase', letterSpacing: 0.4 }}>{k}</span>
      <span style={{ fontSize: 16, fontVariantNumeric: 'tabular-nums', color: '#e6e6ff' }}>{v}</span>
    </div>
  );
}

const headingStyle: CSSProperties = { fontSize: 11, fontWeight: 700, color: '#8b8ba7', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 4 };
const hintStyle: CSSProperties = { fontSize: 11, color: '#6b6b85', lineHeight: 1.4 };
const spawnBtnStyle: CSSProperties = {
  background: 'rgba(255,255,255,0.06)',
  border: '1px solid rgba(255,255,255,0.15)',
  color: '#c4b5fd',
  cursor: 'pointer',
  fontSize: 13,
  padding: '8px 14px',
  borderRadius: 6,
};
const spawnBtnActiveStyle: CSSProperties = { background: 'rgba(99,102,241,0.3)', border: '1px solid rgba(99,102,241,0.55)', color: '#e6e6ff' };
const gridStyle: CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '10px 8px', marginTop: 6 };
